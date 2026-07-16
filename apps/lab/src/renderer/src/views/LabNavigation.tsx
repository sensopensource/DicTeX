import React from "react";

/** The Lab's three task-focused sections (issue #136). */
export type View = "corpus" | "experiments" | "results";

/**
 * The section switcher every view renders at its top. It owns no state: the
 * active view and the navigation callback both come from App, so the routing
 * decision stays in one place.
 */
export function LabNavigation({
  activeView,
  onNavigate,
}: {
  activeView: View;
  onNavigate: (view: View) => void;
}): React.ReactElement {
  const items: { view: View; label: string }[] = [
    { view: "corpus", label: "Corpus" },
    { view: "experiments", label: "Experiments" },
    { view: "results", label: "Results" },
  ];

  return (
    <nav className="panel nav-panel" aria-label="Lab sections">
      {items.map((item) => (
        <button
          aria-current={activeView === item.view ? "page" : undefined}
          className="nav-button"
          disabled={activeView === item.view}
          key={item.view}
          onClick={() => onNavigate(item.view)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
