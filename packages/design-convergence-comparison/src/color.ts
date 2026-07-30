import type { CanonicalColor } from "@design-convergence/shared";

/** CIE L*a*b* triple (D65 reference white). */
export interface Lab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

const POW25_7 = 25 ** 7;
const D65 = { Xn: 95.047, Yn: 100.0, Zn: 108.883 };
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

const deg2rad = (deg: number): number => (deg * Math.PI) / 180;

function srgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

function pivot(t: number): number {
  return t > EPSILON ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

/**
 * Convert a 0..1 sRGB color to CIE L*a*b*. Alpha is ignored — alpha differences
 * are compared separately from hue/lightness. sRGB → linear → XYZ (D65) → Lab.
 */
export function rgbToLab(color: CanonicalColor): Lab {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);

  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) * 100;
  const Y = (r * 0.2126729 + g * 0.7151522 + b * 0.072175) * 100;
  const Z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) * 100;

  const fx = pivot(X / D65.Xn);
  const fy = pivot(Y / D65.Yn);
  const fz = pivot(Z / D65.Zn);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function huePrime(b: number, aPrime: number): number {
  if (b === 0 && aPrime === 0) return 0;
  const h = (Math.atan2(b, aPrime) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

/**
 * CIEDE2000 color difference between two Lab colors. Implements Sharma, Wu &
 * Dalal (2005); verified against their reference dataset. Returns 0 for
 * identical inputs.
 */
export function labCiede2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = huePrime(b1, a1p);
  const h2p = huePrime(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg2rad(dhp) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos(deg2rad(hbarp - 30)) +
    0.24 * Math.cos(deg2rad(2 * hbarp)) +
    0.32 * Math.cos(deg2rad(3 * hbarp + 6)) -
    0.2 * Math.cos(deg2rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const SL =
    1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(deg2rad(2 * dTheta)) * RC;

  return Math.sqrt(
    (dLp / SL) ** 2 +
      (dCp / SC) ** 2 +
      (dHp / SH) ** 2 +
      RT * (dCp / SC) * (dHp / SH),
  );
}

/** CIEDE2000 difference between two canonical sRGB colors. */
export function colorDeltaE(c1: CanonicalColor, c2: CanonicalColor): number {
  return labCiede2000(rgbToLab(c1), rgbToLab(c2));
}
