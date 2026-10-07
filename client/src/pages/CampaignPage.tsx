import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useCampaignStore } from '../stores/useCampaignStore';
import { api } from '../api';
import { setBrands } from '../studio/demoData';
import UploadView from './campaign/UploadView';
import ProcessingView from './campaign/ProcessingView';
import ReviewView from './campaign/ReviewView';
import PlanningView from './campaign/PlanningView';
import '../styles/upload.css';
import '../styles/upload-status.css';
import '../styles/review-landing.css';
import '../styles/planning.css';
import '../styles/planning-story.css';

// One campaign, four stages. The stage is persisted with the campaign so a
// reload or a dashboard deep link reopens exactly where the user left off.
export default function CampaignPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { state, stage, load, rev } = useCampaignStore();
  const loadedId = useCampaignStore(s => s.id);
  const [error, setError] = useState('');

  useEffect(() => {
    api.brands().then(setBrands).catch(() => {});
    load(id).catch(e => setError((e as Error).message));
  }, [id, load]);

  if (error) {
    return (
      <div className="is-upload"><main id="main" className="upload-main"><section className="upload-experience">
        <h1>Campaign not available</h1><p className="upload-intro">{error}</p>
        <div className="upload-actions"><button type="button" className="upload-submit" onClick={() => navigate('/campaigns')}>Back to campaigns</button></div>
      </section></main></div>
    );
  }
  if (!state || loadedId !== id) return <div className="is-upload"><main id="main" className="upload-main" aria-busy="true" /></div>;

  const planningOpen = stage === 'planning';
  return (
    <div className={`is-upload ${planningOpen ? 'is-planning' : ''}`} data-rev={rev}>
      {stage === 'upload' && <UploadView />}
      {stage === 'processing' && <ProcessingView />}
      {stage === 'review' && <ReviewView />}
      {stage === 'planning' && <PlanningView />}
    </div>
  );
}
