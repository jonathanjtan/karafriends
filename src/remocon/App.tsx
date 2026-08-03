import React, { useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router";

import ControlBar from "./components/ControlBar";
import IdentityGate from "./components/IdentityGate";
import NavBar from "./components/NavBar";
import { ToastProvider } from "./components/Toast/ToastContext";
import useUserIdentity from "./hooks/useUserIdentity";
import AdhocLyricsPage from "./pages/AdhocLyricsPage";
import ArtistPage from "./pages/ArtistPage";
import ArtistSearchPage from "./pages/ArtistSearchPage";
import DamRankingPage from "./pages/DamRankingPage";
import HistoryPage from "./pages/HistoryPage";
import HomePage from "./pages/HomePage";
import JoinPage from "./pages/JoinPage";
import JoysoundArtistPage from "./pages/JoysoundArtistPage";
import JoysoundRankingPage from "./pages/JoysoundRankingPage";
import JoysoundSongPage from "./pages/JoysoundSongPage";
import NiconicoPage from "./pages/NiconicoPage";
import OriconRankingPage from "./pages/OriconRankingPage";
import OriconSongPage from "./pages/OriconSongPage";
import ProfilePage from "./pages/ProfilePage";
import SongPage from "./pages/SongPage";
import SongSearchPage from "./pages/SongSearchPage";
import YouTubePage from "./pages/YouTubePage";

import * as styles from "./App.module.scss";
import useQueueNotifications from "./hooks/useQueueNotifications";

const App = () => {
  // A first-time device no longer needs a redirect to the profile page: the
  // identity gate below asks who's holding the phone before anything else
  // mounts, and its "new account" flow collects the name and avatar.
  const { deviceId } = useUserIdentity();
  useQueueNotifications(deviceId);

  // NavBar owns the dark-mode toggle, but it doesn't mount behind the
  // identity gate — without this, an unclaimed device on a dark-mode phone
  // gets a white gate. Applying the persisted choice here covers both.
  useEffect(() => {
    document.documentElement.classList.toggle(
      "dark",
      localStorage.getItem("darkMode") === "true",
    );
  }, []);

  return (
    <HashRouter>
      <div className={styles.app}>
        <IdentityGate>
          <ToastProvider>
            <header>
              <NavBar />
            </header>
            <main>
              <Routes>
                <Route path="/song/:id" element={<SongPage />} />
                <Route path="/artist/:id" element={<ArtistPage />} />
                <Route path="/adhocLyrics/:id" element={<AdhocLyricsPage />} />
                <Route
                  path="/joysoundSong/:id"
                  element={<JoysoundSongPage />}
                />
                <Route
                  path="/joysoundSong/:id/:youtubeVideoId"
                  element={<JoysoundSongPage />}
                />
                <Route
                  path="/joysoundArtist/:id"
                  element={<JoysoundArtistPage />}
                />
                <Route
                  path="/search/song/:query?"
                  element={<SongSearchPage />}
                />
                <Route
                  path="/search/artist/:query?"
                  element={<ArtistSearchPage />}
                />
                <Route
                  path="/search/youtube/:videoId?"
                  element={<YouTubePage />}
                />
                <Route
                  path="/search/niconico/:videoId?"
                  element={<NiconicoPage />}
                />
                {/* The service-specific search routes now open the merged
                    search with that catalog preselected, so old links, the
                    back button and anything still pointing at them keep
                    working. */}
                <Route
                  path="/search/joysoundSong/:query?"
                  element={
                    <SongSearchPage
                      initialSource="JOYSOUND"
                      routeBase="/search/joysoundSong"
                    />
                  }
                />
                <Route
                  path="/search/joysoundArtist/:query?"
                  element={
                    <ArtistSearchPage
                      initialSource="JOYSOUND"
                      routeBase="/search/joysoundArtist"
                    />
                  }
                />
                <Route
                  path="/ranking/joysound/:category?/:period?/:month?"
                  element={<JoysoundRankingPage />}
                />
                <Route
                  path="/ranking/dam/:category?/:period?"
                  element={<DamRankingPage />}
                />
                <Route
                  path="/ranking/oricon/:year?"
                  element={<OriconRankingPage />}
                />
                <Route
                  path="/search/oricon/:query/:artist?"
                  element={<OriconSongPage />}
                />
                <Route path="/join" element={<JoinPage />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/" element={<HomePage />} />
              </Routes>
            </main>
            <footer>
              <ControlBar />
            </footer>
          </ToastProvider>
        </IdentityGate>
      </div>
    </HashRouter>
  );
};

export default App;
