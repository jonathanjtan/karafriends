import React, { useEffect, useRef } from "react";
import { HashRouter, Route, Routes } from "react-router";

import ControlBar from "./components/ControlBar";
import NavBar from "./components/NavBar";
import useUserIdentity from "./hooks/useUserIdentity";
import AdhocLyricsPage from "./pages/AdhocLyricsPage";
import ArtistPage from "./pages/ArtistPage";
import ArtistSearchPage from "./pages/ArtistSearchPage";
import HistoryPage from "./pages/HistoryPage";
import HomePage from "./pages/HomePage";
import JoysoundArtistPage from "./pages/JoysoundArtistPage";
import JoysoundArtistSearchPage from "./pages/JoysoundArtistSearchPage";
import JoysoundSongPage from "./pages/JoysoundSongPage";
import JoysoundSongSearchPage from "./pages/JoysoundSongSearchPage";
import NiconicoPage from "./pages/NiconicoPage";
import ProfilePage from "./pages/ProfilePage";
import SongPage from "./pages/SongPage";
import SongSearchPage from "./pages/SongSearchPage";
import YouTubePage from "./pages/YouTubePage";

import * as styles from "./App.module.scss";
import useQueueNotifications from "./hooks/useQueueNotifications";

const App = () => {
  // Captured before useUserIdentity's effect prompts for (and stores) a
  // nickname, so it still reflects whether this device is joining fresh.
  const isNewDevice = useRef(
    (localStorage.getItem("nickname") || "").length === 0,
  );

  // Send first-time devices to the profile page so they can pick an avatar
  // (the QR code lands them on the home page otherwise). Don't clobber deep
  // links — only redirect when they're landing on the home page. Declared
  // before useUserIdentity so the redirect isn't held up by its nickname
  // prompt (effects flush in hook declaration order).
  useEffect(() => {
    const route = window.location.hash.slice(1);
    if (isNewDevice.current && (route === "" || route === "/")) {
      window.location.hash = "#/profile";
    }
  }, []);

  const { deviceId } = useUserIdentity(true);
  useQueueNotifications(deviceId);

  return (
    <HashRouter>
      <div className={styles.app}>
        <header>
          <NavBar />
        </header>
        <main>
          <Routes>
            <Route path="/song/:id" element={<SongPage />} />
            <Route path="/artist/:id" element={<ArtistPage />} />
            <Route path="/adhocLyrics/:id" element={<AdhocLyricsPage />} />
            <Route path="/joysoundSong/:id" element={<JoysoundSongPage />} />
            <Route
              path="/joysoundSong/:id/:youtubeVideoId"
              element={<JoysoundSongPage />}
            />
            <Route
              path="/joysoundArtist/:id"
              element={<JoysoundArtistPage />}
            />
            <Route path="/search/song/:query?" element={<SongSearchPage />} />
            <Route
              path="/search/artist/:query?"
              element={<ArtistSearchPage />}
            />
            <Route path="/search/youtube/:videoId?" element={<YouTubePage />} />
            <Route
              path="/search/niconico/:videoId?"
              element={<NiconicoPage />}
            />
            <Route
              path="/search/joysoundSong/:query?"
              element={<JoysoundSongSearchPage />}
            />
            <Route
              path="/search/joysoundArtist/:query?"
              element={<JoysoundArtistSearchPage />}
            />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/" element={<HomePage />} />
          </Routes>
        </main>
        <footer>
          <ControlBar />
        </footer>
      </div>
    </HashRouter>
  );
};

export default App;
