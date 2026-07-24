export const PCAN_CHANNELS: Record<string, number> = Object.fromEntries(
  Array.from({ length: 16 }, (_, index) => [`PCAN_USBBUS${index + 1}`, 0x51 + index])
);
export const PCAN_BITRATES: Record<number, number> = {
  125000: 0x031c,
  250000: 0x011c,
  500000: 0x001c,
  1000000: 0x0014
};
export const PCAN_ERROR_OK = 0x00000;
export const PCAN_ERROR_BUSLIGHT = 0x00004;
export const PCAN_ERROR_BUSHEAVY = 0x00008;
export const PCAN_ERROR_BUSOFF = 0x00010;
export const PCAN_ERROR_QRCVEMPTY = 0x00020;
export const PCAN_MESSAGE_STANDARD = 0x00;
export const PCAN_MESSAGE_EXTENDED = 0x02;
