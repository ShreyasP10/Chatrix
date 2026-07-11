import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { localDB } from './lib/db';
import { useStore } from './store/useStore';
import NameModal from './components/NameModal';
import Dashboard from './pages/Dashboard';
import ChatScreen from './pages/ChatScreen';

export default function App() {
  const { user, setUser } = useStore();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    localDB.userProfile.toArray().then((profiles) => {
      if (profiles.length > 0) {
        setUser(profiles[0]);
      }
      setLoading(false);
    });
  }, [setUser]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-dvh bg-black">
        <div className="w-8 h-8 border-2 border-[#333] border-t-[#007AFF] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      {!user && <NameModal />}
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/chat/:code" element={<ChatScreen />} />
      </Routes>
    </BrowserRouter>
  );
}
