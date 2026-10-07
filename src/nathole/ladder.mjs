export const DetectRoleSender = 0;
export const DetectRoleReceiver = 1;

export const NAT_HOLE_MODE_EASY_PAIR = 0;
export const NAT_HOLE_MODE_HARD_PAIR = 3;

export const mode0Behaviors = [
  { receiver: { ttl: 7 } },
  { receiver: { ttl: 7 } },
  { sender: { ttl: 4 }, receiver: { ttl: 4 } },
  { receiver: { ttl: 4 }, sender: { ttl: 4 } },
  { sender: {}, receiver: {} },
  { receiver: {}, sender: {} },
  { sender: { sendDelayMs: 5000 }, receiver: {} },
  { sender: { sendDelayMs: 10000 }, receiver: {} },
  { receiver: {}, sender: { sendDelayMs: 5000 } },
  { receiver: {}, sender: { sendDelayMs: 10000 } },
];

export const mode3Behaviors = [
  { sender: { portsRangeNumber: 10 }, receiver: { ttl: 7, portsRangeNumber: 10 } },
  { sender: { portsRangeNumber: 10 }, receiver: { ttl: 4, portsRangeNumber: 10 } },
  { sender: { portsRangeNumber: 10 }, receiver: { portsRangeNumber: 10 } },
  { receiver: { ttl: 7, portsRangeNumber: 10 }, sender: { portsRangeNumber: 10 } },
  { receiver: { ttl: 4, portsRangeNumber: 10 }, sender: { portsRangeNumber: 10 } },
  { receiver: { portsRangeNumber: 10 }, sender: { portsRangeNumber: 10 } },
];

export function behaviorsForMode(mode) {
  return mode === NAT_HOLE_MODE_HARD_PAIR ? mode3Behaviors : mode0Behaviors;
}
