export const motionTokens = {
  duration: {
    instant: 0.08,
    fast: 0.16,
    normal: 0.26,
    slow: 0.42,
  },
  easing: {
    emphasized: [0.16, 1, 0.3, 1],
    standard: [0.22, 1, 0.36, 1],
  },
  spring: {
    snappy: {
      damping: 24,
      mass: 0.7,
      stiffness: 420,
    },
    soft: {
      damping: 28,
      mass: 0.9,
      stiffness: 260,
    },
  },
} as const;

export type ChangeDirection = "down" | "flat" | "up";

export function getChangeDirection(previous: number | null, current: number | null): ChangeDirection {
  if (previous === null || current === null || !Number.isFinite(previous) || !Number.isFinite(current)) {
    return "flat";
  }

  if (current > previous) {
    return "up";
  }

  if (current < previous) {
    return "down";
  }

  return "flat";
}

export function motionSeconds(value: number): string {
  return `${value}s`;
}

export function cubicBezier(value: readonly [number, number, number, number]): string {
  return `cubic-bezier(${value.join(", ")})`;
}
