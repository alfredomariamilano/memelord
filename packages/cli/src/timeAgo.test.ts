import { describe, expect, it } from "bun:test";

// Replicate the timeAgo function from packages/cli/src/index.ts for testing
function timeAgo(epochSec: number): string {
	const diff = Math.floor(Date.now() / 1000) - epochSec;
	if (diff < 60) return `${diff}s ago`;
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

describe("timeAgo", () => {
	it("should return 'Xs ago' for seconds", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(timeAgo(now - 30)).toBe("30s ago");
		expect(timeAgo(now - 1)).toBe("1s ago");
		expect(timeAgo(now - 59)).toBe("59s ago");
	});

	it("should return 'Xm ago' for minutes", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(timeAgo(now - 60)).toBe("1m ago");
		expect(timeAgo(now - 120)).toBe("2m ago");
		expect(timeAgo(now - 3540)).toBe("59m ago");
	});

	it("should return 'Xh ago' for hours", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(timeAgo(now - 3600)).toBe("1h ago");
		expect(timeAgo(now - 7200)).toBe("2h ago");
		expect(timeAgo(now - 86340)).toBe("23h ago");
	});

	it("should return 'Xd ago' for days", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(timeAgo(now - 86400)).toBe("1d ago");
		expect(timeAgo(now - 172800)).toBe("2d ago");
		expect(timeAgo(now - 259200)).toBe("3d ago");
	});

	it("should handle zero seconds ago", () => {
		const now = Math.floor(Date.now() / 1000);
		expect(timeAgo(now)).toBe("0s ago");
	});
});
