import { CarrierVerification } from './carrier-check';
import { OperatorDashboard } from './operator-dashboard';
export default function Home(){return <main>
  <header className="site-header"><a className="wordmark" href="/">Load desk<span>Carrier sales</span></a><span className="workspace-label">Operations workspace</span></header>
  <CarrierVerification />
  <OperatorDashboard />
  <footer>Carrier sales POC · TMS inventory and Twin call records · Demo bookings are identified in the operator view.</footer>
</main>;}
