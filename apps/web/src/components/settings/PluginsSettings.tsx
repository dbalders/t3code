import { PuzzleIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function PluginsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Plugins" icon={<PuzzleIcon className="size-3.5" />}>
        <div className="p-8">
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <PuzzleIcon className="size-5" />
              </EmptyMedia>
              <EmptyTitle>No plugins installed</EmptyTitle>
              <EmptyDescription>
                Installed plugin bundles will appear here for review and configuration.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </SettingsSection>

      <SettingsSection title="Planned Controls">
        <SettingsRow
          title="Plugin sources"
          description="Configure local or team plugin marketplaces once the host runtime can discover them."
          control={
            <Button size="xs" variant="outline" disabled>
              Add source
            </Button>
          }
        />
        <SettingsRow
          title="Installed plugins"
          description="Enable, disable, update, or remove installed plugins after plugin discovery is wired in."
          control={
            <Button size="xs" variant="outline" disabled>
              Refresh
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
