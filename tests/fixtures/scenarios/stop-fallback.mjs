import { isFailingModel } from './_model-select.mjs';
import failure from './model-429.mjs';
import success from './stop-allow.mjs';

export default {
  onPromptAsync(fake, sessionID, body) {
    return (isFailingModel(body) ? failure : success).onPromptAsync(fake, sessionID, body);
  },
};
