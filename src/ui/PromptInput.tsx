import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export function PromptInput({
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Text color="cyan">╭─ @you</Text>
      <Box>
        <Text color="cyan">╰─› </Text>
        {disabled ? (
          <Text dimColor>{value || "(running...)"}</Text>
        ) : (
          <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
        )}
      </Box>
    </Box>
  );
}
