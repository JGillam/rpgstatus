import { Navigate, Route, Routes } from 'react-router-dom';
import Landing from '@/pages/Landing';
import Create from '@/pages/Create';
import Waiting from '@/pages/Waiting';
import Setup from '@/pages/Setup';
import Gm from '@/pages/Gm';
import Play from '@/pages/Play';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/create" element={<Create />} />
      <Route path="/waiting" element={<Waiting />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/gm" element={<Gm />} />
      <Route path="/play" element={<Play />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
