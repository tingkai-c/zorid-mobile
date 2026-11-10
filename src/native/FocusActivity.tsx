import { Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, lineLimit, padding } from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';
import type { FocusPresentation } from './focus';

function FocusActivityLayout(props: FocusPresentation, environment: LiveActivityEnvironment) {
  'widget';
  const timer = props.status === 'running' ? (
    <Text timerInterval={{ lower: new Date(props.startsAt), upper: new Date(props.endsAt) }} countsDown
      modifiers={[font({ textStyle: 'title2', design: 'monospaced' })]} />
  ) : <Text>{props.elapsedLabel}</Text>;
  return {
    banner: (
      <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 16 }), foregroundStyle(environment.colorScheme === 'dark' ? '#EBF3ED' : '#193F36')]}>
        <Text modifiers={[font({ textStyle: 'caption' })]}>{environment.isStale ? 'Session time reached' : props.statusLabel}</Text>
        <Text modifiers={[font({ textStyle: 'headline' }), lineLimit(2)]}>{props.taskTitle}</Text>
        {timer}
      </VStack>
    ),
    compactLeading: <Text>Focus</Text>,
    compactTrailing: timer,
    minimal: <Text>F</Text>,
    expandedLeading: <Text>{props.statusLabel}</Text>,
    expandedTrailing: timer,
    expandedBottom: <Text modifiers={[lineLimit(2)]}>{props.taskTitle}</Text>,
  };
}

export default createLiveActivity('ZoridFocusActivity', FocusActivityLayout);
