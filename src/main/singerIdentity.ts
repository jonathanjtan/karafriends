// Whether a record belongs to the singer being asked about: personId when
// both sides have one, nickname otherwise. personId is absent on
// pre-registry clients, which is why nickname is kept as the fallback rather
// than looked up. Shared by scores.ts and vocalRanges.ts (and mirrors the
// rule songPlayCount uses in graphql.ts) so a personal best, a play count,
// and a vocal range can't disagree about who sang.
export default function isSameSinger(
  record: { readonly personId: string | null; readonly nickname: string },
  personId: string | null,
  nickname: string,
): boolean {
  if (personId && record.personId) return record.personId === personId;
  return record.nickname === nickname;
}
