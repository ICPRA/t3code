import { createFileRoute } from "@tanstack/react-router";

import { WorkbenchPage } from "../components/workbench/WorkbenchPage";
import { validateWorkbenchSearch } from "../components/workbench/workbenchModel";

function WorkbenchRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkbenchPage
      search={search}
      onSearchChange={(next) => {
        void navigate({ search: next, replace: true });
      }}
    />
  );
}

export const Route = createFileRoute("/workbench")({
  validateSearch: validateWorkbenchSearch,
  component: WorkbenchRoute,
});
