import { withF3, seedSession } from '../f3-fake.mjs';

// Base F3 scenario: catalogs + session routes + one seeded OPC session and one user session.
export default withF3({ setup: seedSession });
