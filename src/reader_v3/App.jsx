import {
  ThStoreProvider,
  ThPreferencesProvider,
  ThI18nProvider,
} from '@edrlab/thorium-web/epub';
import { ThGlobalPreferencesProvider } from '@edrlab/thorium-web/core/preferences';
import '@edrlab/thorium-web/epub/styles';
import Reader from './Reader';

export default function App() {
  return (
    <ThStoreProvider>
      <ThGlobalPreferencesProvider>
        <ThPreferencesProvider>
          <ThI18nProvider lng="en">
            <Reader />
          </ThI18nProvider>
        </ThPreferencesProvider>
      </ThGlobalPreferencesProvider>
    </ThStoreProvider>
  );
}
