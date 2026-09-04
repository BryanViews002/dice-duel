export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="display text-[42px]">{title}</h1>
      <p className="mt-2 text-[12.5px] text-ivory-dim/45">Last updated {updated}</p>

      <div className="mt-4 rounded-lg border border-brass-500/30 bg-brass-500/[0.06] px-4 py-3 text-[12.5px] leading-relaxed text-brass-200/85">
        This is a working draft, not legal advice. Have it reviewed against your
        operating licence and Nigerian law before you take real money — the exact
        conditions of your licence are not something a template can know.
      </div>

      <div className="mt-8 space-y-6 text-[14px] leading-relaxed text-ivory-dim/80 [&_h2]:mb-2 [&_h2]:mt-8 [&_h2]:text-[17px] [&_h2]:text-ivory [&_li]:mb-1.5 [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </div>
  );
}
