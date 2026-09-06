import { HappyRobotClient } from '@happyrobot-ai/sdk';
import { SessionError } from '../../errors.js';
export function createHappyRobotClient() {
  const apiKey = process.env.HAPPYROBOT_API_KEY;
  if (!apiKey) throw new SessionError('HAPPYROBOT_NOT_CONFIGURED');
  // Creating a token also creates a run. Never retry an ambiguous mutation.
  return new HappyRobotClient({ apiKey, cluster: 'us', timeout: 10000, maxRetries: 0 });
}
