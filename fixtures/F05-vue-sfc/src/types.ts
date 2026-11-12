export interface Formatter {
  save(value: number): string;
  readonly label: string;
}
