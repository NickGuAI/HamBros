const DEFAULT_TARGET_SAMPLE_RATE = 24000

class Pcm16WorkletProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super()
    this.targetSampleRate =
      options.processorOptions?.targetSampleRate ?? DEFAULT_TARGET_SAMPLE_RATE
  }

  process(inputs) {
    const firstInput = inputs[0]
    if (!firstInput || firstInput.length === 0) {
      return true
    }

    const channelCount = firstInput.length
    const firstChannel = firstInput[0]
    if (!firstChannel || firstChannel.length === 0) {
      return true
    }

    const frameCount = firstChannel.length
    const monoSamples = new Float32Array(frameCount)

    if (channelCount === 1) {
      monoSamples.set(firstChannel)
    } else {
      for (let i = 0; i < frameCount; i += 1) {
        let sum = 0
        for (let c = 0; c < channelCount; c += 1) {
          sum += firstInput[c]?.[i] ?? 0
        }
        monoSamples[i] = sum / channelCount
      }
    }

    const downsampled = this.downsampleBuffer(monoSamples, sampleRate, this.targetSampleRate)
    if (downsampled.length === 0) {
      return true
    }

    const pcm16 = new Int16Array(downsampled.length)
    for (let i = 0; i < downsampled.length; i += 1) {
      const value = Math.max(-1, Math.min(1, downsampled[i]))
      pcm16[i] = value < 0 ? value * 0x8000 : value * 0x7fff
    }

    this.port.postMessage(pcm16.buffer, [pcm16.buffer])
    return true
  }

  downsampleBuffer(buffer, inputSampleRate, targetSampleRate) {
    if (targetSampleRate >= inputSampleRate) {
      return buffer
    }

    const ratio = inputSampleRate / targetSampleRate
    const outputLength = Math.floor(buffer.length / ratio)
    const result = new Float32Array(outputLength)

    let offsetBuffer = 0
    for (let index = 0; index < outputLength; index += 1) {
      const nextOffsetBuffer = Math.floor((index + 1) * ratio)
      let total = 0
      let count = 0

      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
        total += buffer[i]
        count += 1
      }

      result[index] = count > 0 ? total / count : 0
      offsetBuffer = nextOffsetBuffer
    }

    return result
  }
}

registerProcessor('pcm16-worklet', Pcm16WorkletProcessor)
