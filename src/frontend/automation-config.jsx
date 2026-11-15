import { view } from '@forge/bridge';
import ForgeReconciler, { HelperMessage, Label, Stack, Text, TextArea, Textfield, useProductContext } from '@forge/react';
import React, { useState } from 'react';

// The rule stores an operation name and parameters, never a credential.
function Config({ initial }) {
  const [values, setValues] = useState(initial);
  const update = (patch) => {
    const next = { ...values, ...patch };
    setValues(next);
    if (next.operation.trim()) view.submit({ operation: next.operation.trim(), params: next.params });
  };
  return (
    <Stack space="space.150">
      <Label labelFor="operation">Operation</Label>
      <Textfield id="operation" defaultValue={initial.operation} onChange={(e) => update({ operation: e.target.value })} />
      <HelperMessage>The name of an operation an admin defined in Keybroker.</HelperMessage>
      <Label labelFor="params">Parameters (JSON, smart values allowed)</Label>
      <TextArea id="params" defaultValue={initial.params} onChange={(e) => update({ params: e.target.value })} />
      <HelperMessage>{'For example {"ticket": "{{issue.key}}"}. Leave empty if the operation takes none.'}</HelperMessage>
      <Text>The credential stays in Keybroker. This rule only names the operation.</Text>
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  if (!context) return <Text>Loading…</Text>;
  const inputs = context.extension?.data?.inputs ?? {};
  return <Config initial={{ operation: inputs.operation ?? '', params: inputs.params ?? '' }} />;
}

ForgeReconciler.render(<App />);
