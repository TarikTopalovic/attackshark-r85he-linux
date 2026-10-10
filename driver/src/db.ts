import fs from "node:fs";
import path from "node:path";

export class JsonDbStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  private pathToFile(inputPath: string): string {
    const safeName = Buffer.from(String(inputPath)).toString("base64url");
    return path.join(this.rootDir, `${safeName}.json`);
  }

  private load(inputPath: string): Record<string, string> {
    const filePath = this.pathToFile(inputPath);
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, string>;
  }

  private save(inputPath: string, value: Record<string, string>): void {
    fs.writeFileSync(this.pathToFile(inputPath), JSON.stringify(value, null, 2));
  }

  insert(dbPath: string, key: Uint8Array, value: Uint8Array): void {
    const db = this.load(dbPath);
    db[Buffer.from(key).toString("base64")] = Buffer.from(value).toString("base64");
    this.save(dbPath, db);
  }

  delete(dbPath: string, key: Uint8Array): void {
    const db = this.load(dbPath);
    delete db[Buffer.from(key).toString("base64")];
    this.save(dbPath, db);
  }

  get(dbPath: string, key: Uint8Array): Buffer | null {
    const db = this.load(dbPath);
    const value = db[Buffer.from(key).toString("base64")];
    return value ? Buffer.from(value, "base64") : null;
  }

  keys(dbPath: string): Buffer[] {
    const db = this.load(dbPath);
    return Object.keys(db).map((key) => Buffer.from(key, "base64"));
  }

  values(dbPath: string): Buffer[] {
    const db = this.load(dbPath);
    return Object.values(db).map((value) => Buffer.from(value, "base64"));
  }
}

