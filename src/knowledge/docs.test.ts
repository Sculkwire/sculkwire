import { describe, expect, it } from "vitest";
import { frontMatter } from "./docs.ts";

describe("frontMatter", () => {
  it("strips front matter with LF or CRLF line endings and reads the title", () => {
    const lf = '---\nauthor: steve\ntitle: "Entity Documentation"\n---\n# Heading\n';
    expect(frontMatter(lf)).toEqual({ title: "Entity Documentation", body: "# Heading\n" });
    // Git for Windows checks text files out with CRLF when core.autocrlf is true.
    expect(frontMatter(lf.replaceAll("\n", "\r\n"))).toEqual({ title: "Entity Documentation", body: "# Heading\r\n" });
  });

  it("keeps a file without front matter", () => {
    expect(frontMatter("# Heading\r\ntext")).toEqual({ body: "# Heading\r\ntext" });
  });
});
