import { Button, HStack, Image, Text, VStack } from '@expo/ui/swift-ui';
import {
  activityBackgroundTint, buttonBorderShape, buttonStyle, controlSize, font, foregroundStyle,
  frame, layoutPriority, lineLimit, minimumScaleFactor, monospacedDigit, padding, tint,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';
import type { FocusPresentation } from './focus';

function FocusActivityLayout(props: FocusPresentation, environment: LiveActivityEnvironment) {
  'widget';
  const dark = environment.colorScheme === 'dark';
  const foreground = dark ? '#EBF3ED' : '#193F36';
  const background = dark ? '#172320' : '#F6F4ED';
  const accent = dark ? '#A7DEC9' : '#215E4F';
  // Dynamic Island always has a black background, independently of appearance.
  const islandForeground = '#EBF3ED';
  const islandAccent = '#A7DEC9';
  const stale = environment.isStale && props.status === 'running';
  const statusLabel = stale ? 'Session complete' : props.statusLabel;
  const hasControls = !stale && !!(props.pauseTarget || props.resumeTarget || props.finishTarget);

  const timer = (size: number, width: number, color: string) => {
    const modifiers = [
      font({ size, design: 'rounded', weight: 'semibold' }), monospacedDigit(),
      foregroundStyle(color), lineLimit(1), minimumScaleFactor(0.6),
      // Native timer text otherwise expands to fill the proposed width.
      frame({ width, alignment: 'trailing' }),
    ];
    return props.status === 'running' && !stale ? (
      <Text timerInterval={{ lower: new Date(props.startsAt), upper: new Date(props.endsAt) }}
        countsDown modifiers={modifiers} />
    ) : <Text modifiers={modifiers}>{stale ? '0:00' : props.elapsedLabel}</Text>;
  };

  const controls = (island: boolean) => {
    const color = island ? islandAccent : accent;
    const primaryLabel = island || dark ? '#172320' : '#FFFFFF';
    const primaryModifiers = [
      buttonStyle('borderedProminent'), buttonBorderShape('capsule'), controlSize('small'),
      tint(color), foregroundStyle(primaryLabel), font({ textStyle: 'subheadline', weight: 'semibold' }),
      frame({ minHeight: 44 }),
    ];
    return hasControls ? <HStack spacing={8}>
      {props.pauseTarget ? <Button label="Pause" systemImage="pause.fill" target={props.pauseTarget} modifiers={primaryModifiers} /> : null}
      {props.resumeTarget ? <Button label="Resume" systemImage="play.fill" target={props.resumeTarget} modifiers={primaryModifiers} /> : null}
      {props.finishTarget ? <Button label="Finish" target={props.finishTarget} modifiers={[
        buttonStyle('bordered'), buttonBorderShape('capsule'), controlSize('small'),
        tint(color), foregroundStyle(color), font({ textStyle: 'subheadline', weight: 'semibold' }),
        frame({ minHeight: 44 }),
      ]} /> : null}
    </HStack> : null;
  };
  return {
    banner: (
      <VStack alignment="leading" spacing={8} modifiers={[
        padding({ all: 14 }), foregroundStyle(foreground), activityBackgroundTint(background),
      ]}>
        <HStack alignment="center" spacing={12}>
          <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' }), layoutPriority(1)]}>
            <Text modifiers={[font({ textStyle: 'caption', weight: 'medium' }), foregroundStyle(accent), lineLimit(1)]}>{statusLabel}</Text>
            <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), lineLimit(2)]}>{props.taskTitle}</Text>
          </VStack>
          {timer(28, 104, foreground)}
        </HStack>
        {controls(false)}
      </VStack>
    ),
    bannerSmall: <HStack spacing={8} modifiers={[
      padding({ all: 12 }), foregroundStyle(foreground), activityBackgroundTint(background),
    ]}>
      <Image systemName="timer" size={16} modifiers={[foregroundStyle(accent)]} />
      <Text modifiers={[font({ textStyle: 'caption', weight: 'semibold' }), lineLimit(1)]}>{props.taskTitle}</Text>
      {timer(18, 72, foreground)}
    </HStack>,
    compactLeading: <Image systemName="timer" size={16} modifiers={[foregroundStyle(islandAccent)]} />,
    compactTrailing: timer(13, 52, islandForeground),
    minimal: <Image systemName="timer" size={16} modifiers={[foregroundStyle(islandAccent)]} />,
    expandedLeading: <Text modifiers={[
      font({ textStyle: 'caption', weight: 'semibold' }), foregroundStyle(islandAccent), lineLimit(1),
    ]}>{statusLabel}</Text>,
    expandedTrailing: timer(22, 96, islandForeground),
    expandedBottom: <VStack alignment="leading" spacing={8} modifiers={[
      foregroundStyle(islandForeground), frame({ maxWidth: Infinity, alignment: 'leading' }),
    ]}>
      <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), lineLimit(2)]}>{props.taskTitle}</Text>
      {controls(true)}
    </VStack>,
  };
}

export default createLiveActivity('ZoridFocusActivity', FocusActivityLayout);
