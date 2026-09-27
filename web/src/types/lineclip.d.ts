declare module 'lineclip' {
  type Pt = [number, number];
  type BBox = [number, number, number, number];
  export function clipPolyline(points: Pt[], bbox: BBox, result?: Pt[][]): Pt[][];
  export function clipPolygon(points: Pt[], bbox: BBox): Pt[];
}
