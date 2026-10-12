import { startRelay } from '../../services/ml/offscreenRelay';

startRelay((fn) => browser.runtime.onConnect.addListener(fn as never));
