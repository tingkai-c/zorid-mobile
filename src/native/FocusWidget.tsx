import { Button, HStack, Text, VStack } from '@expo/ui/swift-ui';
import { containerBackground, font, foregroundStyle, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';
import type { FocusPresentation } from './focus';

function FocusLayout(props: FocusPresentation, environment: WidgetEnvironment) {
  'widget';
  const large = environment.widgetFamily === 'systemMedium';
  const dark = environment.colorScheme === 'dark';
  return (
    <VStack alignment="leading" spacing={8} modifiers={[
      containerBackground(dark ? '#172320' : '#F6F4ED', 'widget'),
      foregroundStyle(dark ? '#EBF3ED' : '#193F36'),
    ]}>
      <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' })]}>{props.statusLabel}</Text>
      <Text modifiers={[font({ textStyle: large ? 'title2' : 'headline' }), lineLimit(2)]}>{props.taskTitle}</Text>
      {props.status === 'running' ? (
        <Text timerInterval={{ lower: new Date(props.startsAt), upper: new Date(props.endsAt) }} countsDown
          modifiers={[font({ textStyle: 'largeTitle', design: 'rounded', weight: 'semibold' })]} />
      ) : (
        <Text modifiers={[font({ textStyle: 'title2', design: 'monospaced' })]}>{props.status === 'idle' ? 'Zorid' : props.elapsedLabel}</Text>
      )}
      <HStack spacing={8}>
        {props.pauseTarget ? <Button label="Pause" target={props.pauseTarget} /> : null}
        {props.resumeTarget ? <Button label="Resume" target={props.resumeTarget} /> : null}
        {props.finishTarget ? <Button label="Finish" target={props.finishTarget} /> : null}
      </HStack>
    </VStack>
  );
}

export default createWidget('ZoridFocus', FocusLayout, {
  taskTitle: 'Your next focused session', status: 'idle', statusLabel: 'Ready to focus',
  startsAt: 0, endsAt: 0, elapsedLabel: '0:00', elapsedSeconds: 0,
});
