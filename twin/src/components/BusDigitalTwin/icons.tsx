/** Minimal inline icon set (stroke icons, currentColor). */
import type { ReactElement } from 'react';

type P = { size?: number };
const svg = (size: number, children: ReactElement | ReactElement[]) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

export const IconAccessible = ({ size = 16 }: P) =>
  svg(size, [
    <circle key="h" cx="11" cy="4.2" r="1.7" />,
    <path key="b" d="M10.6 7.5 11 13h5l2.2 5" />,
    <path key="a" d="M10.8 10h4" />,
    <path key="w" d="M8.3 11.2a5 5 0 1 0 7.2 5.9" />,
  ]);

export const IconDoor = ({ size = 16 }: P) =>
  svg(size, [
    <rect key="f" x="4" y="3" width="16" height="18" rx="1.5" />,
    <path key="m" d="M12 3v18" />,
    <path key="l" d="M9.5 12h.01M14.5 12h.01" />,
  ]);

export const IconCheck = ({ size = 16 }: P) =>
  svg(size, [<circle key="c" cx="12" cy="12" r="9" />, <path key="k" d="m8 12.5 2.6 2.6L16 9.5" />]);

export const IconBell = ({ size = 16 }: P) =>
  svg(size, [
    <path key="b" d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />,
    <path key="c" d="M10 20.5a2 2 0 0 0 4 0" />,
  ]);

export const IconRoute = ({ size = 16 }: P) =>
  svg(size, [
    <circle key="a" cx="6" cy="18" r="2.2" />,
    <circle key="b" cx="18" cy="6" r="2.2" />,
    <path key="p" d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" />,
  ]);

export const IconSpeaker = ({ size = 16 }: P) =>
  svg(size, [
    <path key="s" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />,
    <path key="w1" d="M15.5 9a4 4 0 0 1 0 6" />,
    <path key="w2" d="M18 6.5a7.5 7.5 0 0 1 0 11" />,
  ]);

export const CALLOUT_ICONS = {
  accessible: IconAccessible,
  door: IconDoor,
  check: IconCheck,
  bell: IconBell,
  route: IconRoute,
} as const;
