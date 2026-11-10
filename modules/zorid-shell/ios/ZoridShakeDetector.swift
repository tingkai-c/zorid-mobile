struct ZoridShakeDetector {
  private var previousImpulse: (acceleration: SIMD3<Double>, time: Double)?
  private var lastShake = -Double.infinity

  mutating func record(_ acceleration: SIMD3<Double>, at time: Double) -> Bool {
    // Ignore ordinary movement. A shake needs strong impulses in opposite
    // directions within half a second, with a pause before another opening.
    let minimumSquaredForce = 1.2 * 1.2
    guard time - lastShake >= 1,
      dot(acceleration, acceleration) >= minimumSquaredForce else { return false }
    if let previousImpulse,
      time - previousImpulse.time <= 0.5,
      dot(previousImpulse.acceleration, acceleration) <= -minimumSquaredForce {
      self.previousImpulse = nil
      lastShake = time
      return true
    }
    previousImpulse = (acceleration, time)
    return false
  }

  private func dot(_ left: SIMD3<Double>, _ right: SIMD3<Double>) -> Double {
    left.x * right.x + left.y * right.y + left.z * right.z
  }
}
