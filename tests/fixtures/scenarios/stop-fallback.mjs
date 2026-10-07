import { isFailingModel } from './_model-select.mjs';
import failure from './model-429.mjs';
import success from './stop-allow.mjs';

export default {
  onPrompt(fake, sessionID, body) {
    return (isFailingModel(fake.state.sessions[sessionID]) ? failure : success).onPrompt(fake, sessionID, body);
  },
};
