import { hana } from '../assets/sdk.js';
import { startDashboard } from './theme.js';

// Only a Host-opened preview supplies a document. No project lookup.
void startDashboard(hana, { documentPreview: true });
