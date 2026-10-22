import { LABEL_MAX, dialString, directoryEntries, internationalDigits } from "@/lib/phone-numbers";

describe("internationalDigits — a number as iOS's caller ID takes it", () => {
  it.each([
    ["9876543210", "919876543210"],
    ["98765 43210", "919876543210"],
    ["98765-43210", "919876543210"],
    ["+91 98765 43210", "919876543210"],
    ["+91-98765-43210", "919876543210"],
    ["+919876543210", "919876543210"],
    ["(+91) 98765 43210", "919876543210"],
    ["0 98765 43210", "919876543210"],
    ["098765 43210", "919876543210"],
    ["91 98765 43210", "919876543210"],
    ["0919876543210", "919876543210"],
    ["0091 98765 43210", "919876543210"],
    ["+91 098765 43210", "919876543210"],
    ["+91 (0) 98765 43210", "919876543210"],
    // A landline with its area code, written as India writes it.
    ["011 2345 6789", "911123456789"],
    ["(022) 2345 6789", "912223456789"],
  ])("India: %s", (raw, expected) => {
    expect(internationalDigits(raw)).toBe(expected);
  });

  it.each([
    ["+44 20 7946 0958", "442079460958"],
    ["0044 20 7946 0958", "442079460958"],
    ["+1 (415) 555-2671", "14155552671"],
    ["+971 50 123 4567", "971501234567"],
  ])("a number that says its country: %s", (raw, expected) => {
    expect(internationalDigits(raw)).toBe(expected);
  });

  it.each([[""], ["   "], ["2345 6789"], ["12345"], ["0123456789"], ["phone"], ["+0 1234 5678"], ["+1234567"], ["+1234567890123456"]])("left out rather than guessed: %j", (raw) => {
    expect(internationalDigits(raw)).toBeNull();
  });

  it("reads the first number when two are written, and drops an extension", () => {
    expect(internationalDigits("98765 43210 / 91234 56789")).toBe("919876543210");
    expect(internationalDigits("+91 22 2345 6789 ext 214")).toBe("912223456789");
    expect(internationalDigits("98765 43210, 91234 56789")).toBe("919876543210");
  });

  it("puts a bare number in another home country", () => {
    expect(internationalDigits("020 7946 0958", "44")).toBe("442079460958");
    expect(internationalDigits("+91 98765 43210", "44")).toBe("919876543210");
  });
});

describe("directoryEntries — the Call Directory's list", () => {
  it("is in ascending numeric order — a shorter number before a longer one", () => {
    const list = directoryEntries([
      { number: "+91 99999 00000", label: "C" },
      { number: "+1 415 555 2671", label: "A" },
      { number: "98765 43210", label: "B" },
      { number: "+44 20 7946 0958", label: "D" },
    ]);
    expect(list.map((e) => e.number)).toEqual(["14155552671", "442079460958", "919876543210", "919999900000"]);
    const asNumbers = list.map((e) => BigInt(e.number));
    expect(asNumbers.every((n, i) => i === 0 || n > asNumbers[i - 1]!)).toBe(true);
  });

  it("has each number once — the first label Deskzo gave it", () => {
    const list = directoryEntries([
      { number: "98765 43210", label: "Ravi Kumar · Acme" },
      { number: "+91 98765 43210", label: "Ravi · Acme Pvt" },
      { number: "098765-43210", label: "Someone else" },
    ]);
    expect(list).toEqual([{ number: "919876543210", label: "Ravi Kumar · Acme" }]);
  });

  it("leaves out what can't be placed, and what has no label", () => {
    expect(directoryEntries([{ number: "2345 6789", label: "Local" }, { number: "98765 43210", label: "  " }, { number: "91234 56789", label: "Priya · Beta" }])).toEqual([{ number: "919123456789", label: "Priya · Beta" }]);
  });

  it("keeps a label to one line", () => {
    const long = "Venkataraghavan Srinivasaraghavan Ramanujam · Bharat Heavy Electricals Limited, Tiruchirappalli";
    const [entry] = directoryEntries([{ number: "98765 43210", label: `  ${long}\n` }]);
    expect(entry!.label.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(entry!.label.endsWith("…")).toBe(true);
    expect(entry!.label).not.toMatch(/\s…$/);
    expect(directoryEntries([{ number: "98765 43210", label: "Ravi\n  Kumar" }])[0]!.label).toBe("Ravi Kumar");
  });

  it("is empty for nothing", () => {
    expect(directoryEntries([])).toEqual([]);
  });
});

describe("dialString", () => {
  it("keeps digits and a leading +", () => {
    expect(dialString("+91 (98765) 43-210")).toBe("+919876543210");
  });
});
