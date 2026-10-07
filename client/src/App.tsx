import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import DashboardPage from './pages/DashboardPage';
import WelcomePage from './pages/WelcomePage';
import DiscoveryPage from './pages/DiscoveryPage';
import CampaignPage from './pages/CampaignPage';
import PlaceholderPage from './pages/PlaceholderPage';

// Campaign Studio routes. Home is the NORA welcome (New Campaign) →
// Existing Brand discovery → campaign workspace (upload → processing →
// review → planning / Flow Planner, persisted per campaign on the server).
export default function App() {
  return (
    <BrowserRouter>
      <a className="skip-link" href="#main">Skip to content</a>
      <Routes>
        <Route index element={<WelcomePage />} />
        <Route path="campaigns" element={<DashboardPage />} />
        <Route path="new" element={<Navigate to="/" replace />} />
        <Route path="new/brand" element={<DiscoveryPage />} />
        <Route path="campaigns/:id" element={<CampaignPage />} />
        <Route path="schedule" element={<PlaceholderPage title="Schedule" />} />
        <Route path="admin" element={<PlaceholderPage title="Admin" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
