type PersistNormalizerEnabled = (enabled: boolean) => Promise<void>;
type SynchronizeNormalizerEnabled = (enabled: boolean) => void;

export async function persistTrayNormalizerSetting(input: {
  currentEnabled: boolean;
  nextEnabled: boolean;
  persist: PersistNormalizerEnabled;
  synchronize: SynchronizeNormalizerEnabled;
}): Promise<boolean> {
  try {
    await input.persist(input.nextEnabled);
  } catch (error) {
    input.synchronize(input.currentEnabled);
    throw error;
  }

  input.synchronize(input.nextEnabled);
  return input.nextEnabled;
}
