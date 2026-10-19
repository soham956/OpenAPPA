// The SPECIMEN ID rule (docs/demo-script.md): any `SPC-dddd-dddd` in the
// content makes the document High Risk, and Jev is never called.

export const SPECIMEN_ID = /SPC-\d{4}-\d{4}/;

/** The first SPECIMEN ID in `content`, or undefined. */
export function findSpecimenId(content: string): string | undefined {
  return SPECIMEN_ID.exec(content)?.[0];
}

export function hasSpecimenId(content: string): boolean {
  return SPECIMEN_ID.test(content);
}
