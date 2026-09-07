import { CarrierVerification } from '../features/carrier-verification/carrier-check';
import { OperatorDashboard } from '../features/operator-dashboard/operator-dashboard';
export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="wordmark" href="/">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="wordmark-name">HappyRobot Logistics</span>
          <span className="wordmark-context">Operations</span>
        </a>
        <span className="workspace-label">
          <i className="status-dot" aria-hidden="true" />
          Demo workspace <span>·</span> Operator console
        </span>
      </header>
      <CarrierVerification />
      <OperatorDashboard />
      <footer>
        <span>HappyRobot Logistics · Operations</span>
        <span>Load coverage, booking approvals and carrier follow-up.</span>
      </footer>
    </main>
  );
}
