import { Navigate, Route, Routes } from 'react-router-dom';
import Landing from '@/pages/Landing';
import Waiting from '@/pages/Waiting';
import Gm from '@/pages/Gm';
import Play from '@/pages/Play';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/waiting" element={<Waiting />} />
      <Route path="/gm" element={<Gm />} />
      <Route path="/play" element={<Play />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
