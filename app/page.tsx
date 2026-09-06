import { CarrierVerification } from './carrier-check';

export default function Home() {
  return <main>
    <header><span className="eyebrow">CARRIER SALES · LOCAL POC</span>
      <h1>Load desk</h1>
      <p>Tell the agent your MC number and route. We’ll handle the checks and find your next load.</p>
    </header>
    <CarrierVerification />
    <footer>Local POC · The agent can check authority, verify a mock OTP and search live loads. {process.env.BOOKING_ENABLED === 'true' ? 'Rate negotiation and TMS booking enabled. Senior-representative handoff is simulated.' : process.env.NEGOTIATION_ENABLED === 'true' ? 'Rate negotiation is enabled; booking is not enabled.' : 'Negotiation is awaiting activation. Booking is not enabled.'}</footer>
  </main>;
}
