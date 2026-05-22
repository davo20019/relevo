import { Box, Text } from "ink";

// One leading angle quote in cyan + the prompt at default weight. The glyph
// and indentation are enough to signal "this is what you said" without a
// header line saying so.
export function UserPrompt({ prompt }: { prompt: string }) {
  const shown = prompt.trim() ? prompt : "(empty)";
  return (
    <Box paddingLeft={1} marginTop={0} marginBottom={1}>
      <Text color="cyan" bold>
        ›{" "}
      </Text>
      <Text>{shown}</Text>
    </Box>
  );
}
