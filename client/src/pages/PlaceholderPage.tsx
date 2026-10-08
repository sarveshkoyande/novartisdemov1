import { useEffect } from 'react';
import AccelerateHeader from '../components/AccelerateHeader';

// Dummy destination for top-bar tabs that are not part of this demo yet.
export default function PlaceholderPage({ title }: { title: string }) {
  useEffect(() => { document.title = `Campaign Accelerator · ${title}`; }, [title]);
  return (
    <div className="is-dashboard">
      <AccelerateHeader />
      <main id="main" className="dashboard-main">
        <section className="dash-greeting"><div><div className="dash-greeting-line"><h1 tabIndex={-1}>{title}</h1><p>This area is coming soon.</p></div></div></section>
        <p className="dash-demo-note">Placeholder · {title} is not part of this demo.</p>
      </main>
    </div>
  );
}
