import type { CssPx, PdfPx, RetinaPx } from "../../core/model";

export type BBox<Unit> = Readonly<{
  x: Unit;
  y: Unit;
  width: Unit;
  height: Unit;
}>;

export type CssBBox = BBox<CssPx>;
export type PdfBBox = BBox<PdfPx>;
export type RetinaBBox = BBox<RetinaPx>;

export const bbox = <Unit>(x: Unit, y: Unit, width: Unit, height: Unit): BBox<Unit> => ({
  x,
  y,
  width,
  height,
});

export const pdfToRetinaBBox = (pdf: PdfBBox, scale: number): RetinaBBox =>
  bbox(
    (pdf.x as number * scale) as RetinaPx,
    (pdf.y as number * scale) as RetinaPx,
    (pdf.width as number * scale) as RetinaPx,
    (pdf.height as number * scale) as RetinaPx,
  );

export const retinaToCssBBox = (retina: RetinaBBox): CssBBox =>
  bbox(
    (retina.x as number / 2) as CssPx,
    (retina.y as number / 2) as CssPx,
    (retina.width as number / 2) as CssPx,
    (retina.height as number / 2) as CssPx,
  );

export const cssToRetinaBBox = (css: CssBBox): RetinaBBox =>
  bbox(
    (css.x as number * 2) as RetinaPx,
    (css.y as number * 2) as RetinaPx,
    (css.width as number * 2) as RetinaPx,
    (css.height as number * 2) as RetinaPx,
  );

export const pdfToCssBBox = (pdf: PdfBBox, scale: number): CssBBox =>
  retinaToCssBBox(pdfToRetinaBBox(pdf, scale));

export const cssToPdfBBox = (css: CssBBox, scale: number): PdfBBox => {
  const retina = cssToRetinaBBox(css);
  return bbox(
    ((retina.x as number) / scale) as PdfPx,
    ((retina.y as number) / scale) as PdfPx,
    ((retina.width as number) / scale) as PdfPx,
    ((retina.height as number) / scale) as PdfPx,
  );
};
