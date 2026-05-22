import { Box, Text } from "ink";

export function UserPrompt({ prompt }: { prompt: string }) {
  const shown = prompt.trim() ? prompt : "(empty)";
  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={0} marginBottom={1}>
      <Text>
        <Text bold inverse color="cyan">
          @you
        </Text>
        <Text dimColor> submitted</Text>
      </Text>
      <Text bold>{shown}</Text>
    </Box>
  );
}
