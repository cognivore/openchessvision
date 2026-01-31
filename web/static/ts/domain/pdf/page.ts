import type { PageIndex, PageNum } from "../../core/model";

export const toPageIndex = (page: PageNum): PageIndex => ((page as number) - 1) as PageIndex;
export const toPageNum = (index: PageIndex): PageNum => ((index as number) + 1) as PageNum;

export const clampPage = (page: number, totalPages: number): PageNum =>
  (Math.min(Math.max(page, 1), totalPages)) as PageNum;
