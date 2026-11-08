import type { SettingsSnapshot } from '@shared/space-api'
import { SettingRow } from './parts'

/** Settings > About: the app's name (package.json productName), version and license, from main's snapshot. */
export function AboutSection({ about }: { about: SettingsSnapshot['about'] }) {
  return (
    <>
      <SettingRow name={about.name} description={`Version ${about.version}`} />
      {about.license && (
        <SettingRow name="License">
          <span className="menu__meta">{`${about.license} license`}</span>
        </SettingRow>
      )}
    </>
  )
}
