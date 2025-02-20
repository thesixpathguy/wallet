import { Box, Text } from '@stacks/ui';

import { HasChildren } from '@app/common/has-children';

export function PsbtUnsignedOutputListLayout({ children }: HasChildren) {
  return (
    <Box background="white" borderTopLeftRadius="16px" borderTopRightRadius="16px" p="loose">
      <Text fontWeight={500}>Outputs</Text>
      {children}
    </Box>
  );
}
