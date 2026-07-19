import { InvestorCurve } from "@/components/InvestorCurve";
import { AutoRefresh } from "@/components/AutoRefresh";
import { getInvestorCurve } from "@/lib/queries";

export const dynamic = "force-dynamic";

// Investor-facing performance surface — the three-layer story (models · paper ·
// live), live-updating through the trading day. Auto-refreshes so a shared link
// stays current for the meeting.
export default async function InvestorPage() {
  const data = await getInvestorCurve();
  return (
    <main style={{ minHeight: "100vh", background: "var(--page)" }}>
      <AutoRefresh ms={30000} />
      <InvestorCurve data={data} />
    </main>
  );
}
