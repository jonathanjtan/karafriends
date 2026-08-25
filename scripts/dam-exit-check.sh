#!/usr/bin/env bash
# Is this exit IP good enough for DAM?
#
# Usage:
#   ./dam-exit-check.sh                          # test the current default route (VPN or not)
#   ./dam-exit-check.sh http://user:pass@host:port   # test through a candidate HTTP proxy
#
# DAM has two independent gates and you must pass BOTH:
#   1. win10.clubdam.com (CloudFront)  -> geo + anonymizer reputation. Fails closed
#      with an "Unauthorized access" HTML page instead of JSON.
#   2. cds1-clubdam...ipcasting.jp     -> datacenter/VPN IP reputation. 403s the m3u8.
# Gate 2 can only be truly tested by playing a song, but gate 1 is a fast pre-filter:
# if login is blocked, nothing else matters.

set -u
PROXY="${1:-}"
CURL=(curl -s --max-time 25)
[ -n "$PROXY" ] && CURL+=(--proxy "$PROXY")

echo "=== 1. exit IP ==="
IPJSON=$("${CURL[@]}" 'http://ip-api.com/json/?fields=status,country,countryCode,city,isp,as,proxy,hosting,query')
echo "$IPJSON"
CC=$(printf '%s' "$IPJSON" | sed -n 's/.*"countryCode":"\([^"]*\)".*/\1/p')
FLAGGED=$(printf '%s' "$IPJSON" | sed -n 's/.*"proxy":\([a-z]*\).*/\1/p')
HOSTING=$(printf '%s' "$IPJSON" | sed -n 's/.*"hosting":\([a-z]*\).*/\1/p')

echo
if [ "$CC" != "JP" ]; then
  echo "  [FAIL] not a Japanese IP ($CC). Login will be geo-blocked."
else
  echo "  [ok]   Japan IP."
fi
[ "$FLAGGED" = "true" ] && echo "  [WARN] flagged proxy=true. This is what burns DAM exits."
[ "$HOSTING" = "true" ] && echo "  [WARN] flagged hosting=true. CDN 403s datacenter ranges."
[ "$FLAGGED" = "false" ] && [ "$HOSTING" = "false" ] && echo "  [ok]   clean (not flagged proxy/hosting). This is what you want."

echo
echo "=== 2. DAM auth gate (dummy creds; we only care JSON vs HTML) ==="
BODY=$("${CURL[@]}" -X POST \
  'https://win10.clubdam.com/cwa/win/minsei/auth/LoginByDamtomoMemberId.api' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -H 'User-Agent: WindowsApplication' \
  -H 'win10-access-key: mbAmgk3GuCOKAgL8dCQR' \
  --data 'loginId=000000000000&password=zzzzzzzz&format=json')

if printf '%s' "$BODY" | grep -qi 'Unauthorized access'; then
  echo "  [FAIL] CloudFront returned the block page. This exit is banned."
elif printf '%s' "$BODY" | grep -q '{'; then
  echo "  [PASS] got JSON back. The auth gate is open from this exit."
  echo "         (an auth error in the JSON is expected; the creds are fake)"
else
  echo "  [????] unexpected response:"
  printf '%s' "$BODY" | head -c 300; echo
fi

echo
echo "=== 3. DAM CDN gate (the one that is actually failing) ==="
# A blocked exit is rejected at the openresty edge before any token lookup:
# x-oke-front1-time: 0.000 and an identical 992-byte page for ANY path.
# This is a COMPARATIVE probe. Record it on a known-bad exit (Nord JP today
# gives 403/992) and compare against a candidate. A different status or length
# means the edge is at least talking to you.
HDRS=$("${CURL[@]}" -D - -o /dev/null \
  'https://cds1-clubdam.k56.ipcasting.jp/0000000000000000000000000000000000000000000000000000000000000000/4461-09sk_1.mp4.m3u8')
CODE=$(printf '%s' "$HDRS" | sed -n 's|^HTTP/[0-9.]* \([0-9]*\).*|\1|p' | tail -1)
LEN=$(printf '%s' "$HDRS" | sed -n 's/^[Cc]ontent-[Ll]ength: *\([0-9]*\).*/\1/p' | tail -1)
echo "  status=$CODE content-length=${LEN:-?}"
if [ "$CODE" = "403" ] && [ "${LEN:-0}" = "992" ]; then
  echo "  [FAIL] matches the known edge-block fingerprint (403 / 992 bytes)."
  echo "         This is the gate that breaks DAM playback."
else
  echo "  [????] differs from the known-bad fingerprint, which is promising."
  echo "         Confirm for real: play a DAM song and check"
  echo "         \$TMPDIR/karafriends_tmp/dam-<id>.log for a 403."
fi
