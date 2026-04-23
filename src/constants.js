export const USER_ROLES = ['super_admin', 'admin', 'user'];
export const USER_STATUSES = ['active', 'disabled'];
export const DEVICE_STATUSES = ['Online', 'Offline', 'Unknown'];

export const USER_PERMISSIONS = ['users.block', 'devices.crud', 'admins.crud'];
export const LEGACY_PERMISSION_ALIASES = Object.freeze({
  crud: USER_PERMISSIONS,
  view: [],
});
