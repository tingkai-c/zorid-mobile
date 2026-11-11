/** Typechecked SDK 58 examples. Nothing requests permission or starts work at import. */
import { device } from '../src/device';
import type { Battery, Network, Sensors } from '../src/device/expo';

function requireForeground(appState: { currentState: string | null | undefined }) {
  if (appState.currentState !== 'active') throw new Error('Open the app before starting this interaction.');
}
async function foregroundAPIs() {
  if (!device.available) throw new Error('Install a compatible Zorid runtime zorid-5 iPhone build first.');
  const apis = await import('../src/device/expo');
  requireForeground(apis.AppState);
  return apis;
}

/** Call from a document-import button. iOS picker copies are temporary. */
export async function pickRetainAndPreviewFile() {
  const { FileSystem, Crypto } = await foregroundAPIs();
  const selection = await FileSystem.File.pickFileAsync({ multipleFiles: false });
  if (selection.canceled) return { canceled: true as const };
  const folder = new FileSystem.Directory(FileSystem.Paths.document, 'apps', 'native-capabilities', 'imports');
  folder.create({ intermediates: true, idempotent: true });
  const file = new FileSystem.File(folder, `${Crypto.randomUUID()}-${selection.result.name}`);
  await selection.result.copy(file);
  const canPreview = await file.canPreview();
  if (canPreview) await file.preview();
  return { canceled: false as const, uri: file.uri, canPreview };
}

/** Preserve the complete permission response, including iOS accuracy and scope. */
export async function locateOnceWhenInUse() {
  const { Location, AppState } = await foregroundAPIs();
  let permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return { permission, position: null };
  requireForeground(AppState);
  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  return { permission, position };
}

/** Contact selection is separate from requesting address-book access. */
export async function pickContact() {
  const { Contacts } = await foregroundAPIs();
  const permission = await Contacts.getPermissionsAsync();
  const contact = await Contacts.Contact.presentPicker();
  return { canceled: contact === null, contact, permission };
}

/** A small requested-field query; limited contact authorization stays limited. */
export async function readFirstContactPage() {
  const { Contacts } = await foregroundAPIs();
  let permission = await Contacts.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await Contacts.requestPermissionsAsync();
  if (!permission.granted) return { permission, contacts: [] };
  const contacts = await Contacts.Contact.getAllDetails(
    [Contacts.ContactField.FULL_NAME, Contacts.ContactField.EMAILS], { limit: 20, offset: 0 });
  return { permission, contacts };
}

/** Call only from an explicit expand-contact-access action on iOS 18+. */
export async function expandLimitedContactAccess() {
  const { Contacts, Platform } = await foregroundAPIs();
  const before = await Contacts.getPermissionsAsync();
  if (Platform.OS !== 'ios' || Number.parseInt(String(Platform.Version), 10) < 18 || before.accessPrivileges !== 'limited') {
    return { permission: before, contacts: [] };
  }
  const contacts = await Contacts.Contact.presentAccessPicker();
  return { permission: await Contacts.getPermissionsAsync(), contacts };
}

/** Use useAudioPlayer in React components; this imperative example owns cleanup. */
export async function playForegroundAudio(source: string) {
  const { Audio, AppState } = await foregroundAPIs();
  await Audio.setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false,
    allowsBackgroundRecording: false, playsInSilentMode: true, interruptionMode: 'mixWithOthers' });
  requireForeground(AppState);
  const player = Audio.createAudioPlayer(source);
  let disposed = false;
  const subscription = AppState.addEventListener('change', state => { if (state !== 'active') dispose(); });
  function dispose() {
    if (disposed) return;
    disposed = true;
    subscription.remove();
    try { player.pause(); } finally { player.remove(); }
  }
  try { player.play(); } catch (error) { dispose(); throw error; }
  return { player, dispose };
}

/** Stop on screen unmount or inactivity; restarting is a fresh explicit action. */
export async function observeAccelerometer(onMeasurement: (value: Sensors.AccelerometerMeasurement) => void) {
  const { Sensors, AppState } = await foregroundAPIs();
  if (!await Sensors.Accelerometer.isAvailableAsync()) throw new Error('This device has no available accelerometer.');
  let permission = await Sensors.Accelerometer.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await Sensors.Accelerometer.requestPermissionsAsync();
  if (!permission.granted) return { permission, dispose() {} };
  requireForeground(AppState);
  Sensors.Accelerometer.setUpdateInterval(250);
  let disposed = false;
  const sensor = Sensors.Accelerometer.addListener(onMeasurement);
  const appState = AppState.addEventListener('change', state => { if (state !== 'active') dispose(); });
  function dispose() { if (!disposed) { disposed = true; sensor.remove(); appState.remove(); } }
  return { permission, dispose };
}

/** Unknown battery values and optional network fields are returned unchanged. */
export async function readPowerAndNetwork() {
  const { Battery, Network, Device } = await foregroundAPIs();
  const [power, network] = await Promise.all([Battery.getPowerStateAsync(), Network.getNetworkStateAsync()]);
  return { power, network, isDevice: Device.isDevice, modelName: Device.modelName };
}

type PowerNetworkChange = { type: 'network'; value: Network.NetworkState }
  | { type: 'batteryLevel'; value: Battery.BatteryLevelEvent }
  | { type: 'batteryState'; value: Battery.BatteryStateEvent }
  | { type: 'lowPowerMode'; value: Battery.PowerModeEvent };
export async function observePowerAndNetwork(onChange: (event: PowerNetworkChange) => void) {
  const { Battery, Network, AppState } = await foregroundAPIs();
  let disposed = false;
  const subscriptions = [
    Network.addNetworkStateListener(value => onChange({ type: 'network', value })),
    Battery.addBatteryLevelListener(value => onChange({ type: 'batteryLevel', value })),
    Battery.addBatteryStateListener(value => onChange({ type: 'batteryState', value })),
    Battery.addLowPowerModeListener(value => onChange({ type: 'lowPowerMode', value })),
  ];
  const appState = AppState.addEventListener('change', state => { if (state !== 'active') dispose(); });
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.remove();
    appState.remove();
  }
  return { dispose };
}

/** Pass a trusted HTML document. Escape interpolated notes before building HTML. */
export async function exportAndPreviewPDF(html: string) {
  const { Print, FileSystem, Crypto } = await foregroundAPIs();
  const result = await Print.printToFileAsync({ html });
  const folder = new FileSystem.Directory(FileSystem.Paths.document, 'apps', 'native-capabilities', 'exports');
  folder.create({ intermediates: true, idempotent: true });
  const retained = new FileSystem.File(folder, `${Crypto.randomUUID()}.pdf`);
  await new FileSystem.File(result.uri).copy(retained);
  if (await retained.canPreview()) await retained.preview();
  return { uri: retained.uri, numberOfPages: result.numberOfPages };
}
