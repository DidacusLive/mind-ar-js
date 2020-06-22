const {upsampleBilinear, downsampleBilinear} = require('../utils/images.js');

const MAX_SUBPIXEL_DISTANCE_SQR = 3 * 3;
const LAPLACIAN_SQR_THRESHOLD = 3 * 3;
const EDGE_THRESHOLD = 4.0;
const EDGE_HESSIAN_THRESHOLD = ((EDGE_THRESHOLD+1) * (EDGE_THRESHOLD+1) / EDGE_THRESHOLD);
const MAX_FEATURE_POINTS = 500;
const PRUNE_FEATURES_NUM_BUCKETS = 10; // per dimension

const ORIENTATION_NUM_BINS = 36;
const ORIENTATION_GAUSSIAN_EXPANSION_FACTOR = 3.0;
const ORIENTATION_REGION_EXPANSION_FACTOR = 1.5;
const ORIENTATION_SMOOTHING_ITERATIONS = 5;
const ORIENTATION_PEAK_THRESHOLD = 0.8;

const ONE_OVER_2PI = 0.159154943091895;

// Detect minima and maximum in Laplacian images
const detect = ({gaussianPyramid, dogPyramid}) => {
  const originalWidth = dogPyramid.images[0].width;
  const originalHeight = dogPyramid.images[0].height;

  const mK = Math.pow(2, 1.0 / (gaussianPyramid.numScalesPerOctaves-1));

  const featurePoints = [];

  for (let k = 1; k < dogPyramid.images.length - 1; k++) {
    let image0 = dogPyramid.images[k-1];
    let image1 = dogPyramid.images[k];
    let image2 = dogPyramid.images[k+1];

    const octave = Math.floor(k / dogPyramid.numScalesPerOctaves);
    const scale = k % dogPyramid.numScalesPerOctaves;

    let hasUpsample = false;
    let hasPadOneWidth = false;
    let hasPadOneHeight = false;

    if ( Math.floor(image0.width/2) == image1.width) {
      image0 = downsampleBilinear({image: image0});
    }

    if ( Math.floor(image1.width/2) == image2.width) {
      hasUpsample = true;
      hasPadOneWidth = image1.width % 2 === 1;
      hasPadOneHeight = image1.height % 2 === 1;
      image2 = upsampleBilinear({image: image2, padOneWidth: hasPadOneWidth, padOneHeight: hasPadOneHeight});
    }

    const width = image1.width;
    const height = image1.height;

    const neighbours = [
      0, -1, 1,
      -image1.width, -image1.width-1, -image1.width+1,
      image1.width, image1.width-1, image1.width+1
    ];

    // In upsample image, ignore the border
    // it's possible to further pad one more line (i.e. upsacale 2x2 -> 5x5) at the end, so ignore one more line
    let startI = hasUpsample? 2: 1;
    let startJ = startI;

    // should it be "image1.width -2" ? but this yield consistent result with artoolkit
    let endI = hasUpsample? image1.width - 3: image1.width - 1;
    let endJ = hasUpsample? image1.height - 3: image1.height - 1;
    if (hasPadOneWidth) endI -= 1;
    if (hasPadOneHeight) endJ -= 1;

    for (let j = startJ; j < endJ; j++) {
      for (let i = startI; i < endI; i++) {
        const pos = j*image1.width + i;
        const v = image1.data[pos];

        if (v*v < LAPLACIAN_SQR_THRESHOLD) continue;

        // Step 1: find maxima/ minima in laplacian images

        let isMax = true;
        for (let d = 0; d < neighbours.length; d++) {
          if (v <= image0.data[pos+neighbours[d]]) {isMax = false; break};
          if (v <= image2.data[pos+neighbours[d]]) {isMax = false; break};
          if (d !== 0 && v <= image1.data[pos+neighbours[d]]) {isMax = false; break};
        }

        let isMin = true;
        for (let d = 0; d < neighbours.length; d++) {
          if (v >= image0.data[pos+neighbours[d]]) {isMin = false; break};
          if (v >= image2.data[pos+neighbours[d]]) {isMin = false; break};
          if (d !== 0 && v >= image1.data[pos+neighbours[d]]) {isMin = false; break};
        }

        if (!isMax && !isMin) continue; // extrema -> feature point

        // Step 2: sub-pixel refinement (I'm not sure what that means. Any educational ref?)

        // Compute spatial derivatives
        const dx = 0.5 * (image1.data[pos + 1] - image1.data[pos - 1]);
        const dy = 0.5 * (image1.data[pos + width] - image1.data[pos - width]);
        const dxx = image1.data[pos + 1] + image1.data[pos - 1] - 2 * image1.data[pos];
        const dyy = image1.data[pos + width] + image1.data[pos - width] - 2 * image1.data[pos];
        const dxy = 0.25 * (image1.data[pos - width -1] + image1.data[pos + width + 1] - image1.data[pos - width +1] - image1.data[pos + width - 1]);

        // Compute scale derivates
        const ds = 0.5 * (image2.data[pos] - image0.data[pos]);
        const dss = image2.data[pos] + image0.data[pos] - 2 * image1.data[pos];
        const dxs = 0.25 * ((image0.data[pos-1] - image0.data[pos+1]) + (-image2.data[pos-1] + image2.data[pos+1]));
        const dys = 0.25 * ((image0.data[pos-width] - image0.data[pos+width]) + (-image2.data[pos-width] + image2.data[pos+width]));

        // Hessian matrix
        const hessian = [
          dxx, dxy, dxs,
          dxy, dyy, dys,
          dxs, dys, dss
        ];

        // b
        const b = [
          -dx,
          -dy,
          -ds
        ];

        // Solve H * u = b;
        const u = _solveSymmetric33({A: hessian, b: b});
        if (u === null) continue; // no solution

        // If points move too much in the sub-pixel update, then the point probably unstable.
        if (u[0] * u[0] + u[1] * u[1] > MAX_SUBPIXEL_DISTANCE_SQR) continue;

        // compute edge score
        const det = (dxx * dyy) - (dxy * dxy);
        if (det === 0) continue;

        const edgeScore = (dxx + dyy) * (dxx + dyy) / det;
        if (Math.abs(edgeScore) >= EDGE_HESSIAN_THRESHOLD ) continue;

        const score = v - (b[0] * u[0] + b[1] * u[1] + b[2] * u[2]);
        if (score * score < LAPLACIAN_SQR_THRESHOLD) continue;

        // original x = x*2^n + 2^(n-1) - 0.5
        // original y = y*2^n + 2^(n-1) - 0.5
        const originalX = i * Math.pow(2, octave) + Math.pow(2, octave-1) - 0.5;
        const originalY = j * Math.pow(2, octave) + Math.pow(2, octave-1) - 0.5;

        const newX = originalX + u[0] * Math.pow(2, octave);
        const newY = originalY + u[1] * Math.pow(2, octave);
        if (newX < 0 || newX >= originalWidth || newY < 0 || newY >= originalHeight) continue;

        const spScale = Math.min(Math.max(0, scale + u[2]), dogPyramid.numScalesPerOctaves);
        const newSigma = Math.pow(mK, spScale) * (1 << octave);

        let newOctaveX = newX * (1.0 / Math.pow(2, octave)) + 0.5 * (1.0 / Math.pow(2, octave)) - 0.5;
        let newOctaveY = newY * (1.0 / Math.pow(2, octave)) + 0.5 * (1.0 / Math.pow(2, octave)) - 0.5;
        newOctaveX = Math.floor(newOctaveX + 0.5);
        newOctaveY = Math.floor(newOctaveY + 0.5);

        featurePoints.push({
          octave: octave,
          scale: scale,
          octaveX: newOctaveX,
          octaveY: newOctaveY,
          x: newX,
          y: newY,
          sigma: newSigma,
          score: score,
        })
      }
    }
  }
  if (window.DEBUG) {
    const fps = window.debugContent.featurePoints2[window.debug.keyframeIndex];
    console.log("featurepoints2", featurePoints.length, 'vs', fps.length);
    for (let i = 0; i < fps.length; i++) {
      const fp1 = featurePoints[i];
      const fp2 = fps[i];
      //if (!window.cmpObj(fp1, fp2, ['x', 'y', 'score', 'sigma', 'spScale', 'edgeScore'])) {
      if (!window.cmpObj(fp1, fp2, ['x', 'y', 'score', 'sigma'])) {
        console.log("INCORRECT featurepoint2", fp1, fp2);
      }
    }
  }

  const prunedFeaturePoints = _pruneFeatures({featurePoints: featurePoints, width: originalWidth, height: originalHeight});

  console.log("pruned feature points length", prunedFeaturePoints.length);

  // compute feature orientations
  const gradients = _computeGradients({pyramid: gaussianPyramid});

  const orientedFeaturePoints = [];
  for (let i = 0; i < prunedFeaturePoints.length; i++) {
    if (window.DEBUG) {
      window.debug.orientationComputeIndex = i;
    }

    const fp = prunedFeaturePoints[i];
    const octaveSigma = fp.sigma * (1.0 / Math.pow(2, fp.octave));

    const gradient = gradients[fp.octave * gaussianPyramid.numScalesPerOctaves + fp.scale];
    const angles = _computeOrientation({x: fp.octaveX, y: fp.octaveY, sigma: octaveSigma, octave: fp.octave, scale: fp.scale, gradient: gradient});

    for (let j = 0; j < angles.length; j++) {
      orientedFeaturePoints.push(Object.assign({
        angle: angles[j]
      }, prunedFeaturePoints[i]));
    }
  }

  if (window.DEBUG) {
    const fps = window.debugContent.featurePoints4[window.debug.keyframeIndex];
    console.log("featurepoints4", orientedFeaturePoints.length, 'vs', fps.length);
    for (let i = 0; i < fps.length; i++) {
      const fp1 = orientedFeaturePoints[i];
      const fp2 = fps[i];
      //if (!window.cmpObj(fp1, fp2, ['x', 'y', 'score', 'sigma', 'spScale', 'edgeScore', 'angle'])) {
      if (!window.cmpObj(fp1, fp2, ['x', 'y', 'score', 'sigma', 'angle'])) {
        console.log("INCORRECT featurepoint4", fp1, fp2);
      }
    }
  }

  return orientedFeaturePoints;
}

const _computeOrientation = (options) => {
  const {x, y, sigma, octave, scale, gradient} = options;

  const gwSigma = Math.max(1.0, ORIENTATION_GAUSSIAN_EXPANSION_FACTOR * sigma);
  const gwScale = -1.0 / (2 * gwSigma * gwSigma);

  const radius = ORIENTATION_REGION_EXPANSION_FACTOR * gwSigma;
  const radius2 = Math.ceil( radius * radius - 0.5);

  const x0 = Math.max(0, x - Math.floor(radius + 0.5));
  const x1 = Math.min(gradient.width-1, x + Math.floor(radius + 0.5));
  const y0 = Math.max(0, y - Math.floor(radius + 0.5));
  const y1 = Math.min(gradient.height-1, y + Math.floor(radius + 0.5));

  if (window.DEBUG) {
    const o = window.debugContent.orientationCompute[window.debug.keyframeIndex][window.debug.orientationComputeIndex];
    if (Math.floor(o.x + 0.5) !== x || Math.floor(o.y + 0.5) !== y) {
      console.log("INCORRECT orientation input");
    }
    if (x0 !== o.x0 || x1 !== o.x1 || y0 !== o.y0 || y1 !== o.y1) {
      console.log("INCORRECT xy range");
    }
    if (radius2 !== o.radius2) {
      console.log("INCORRECT radius", radius, radius2, o.radius, o.radius2);
    }
    window.debug.fbinIndex = -1;
  }

  const histogram = [];
  for (let i = 0; i < ORIENTATION_NUM_BINS; i++) {
    histogram.push(0);
  }

  for (let yp = y0; yp <= y1; yp++) {
    const dy = yp - y;
    const dy2 = dy * dy;

    for (let xp = x0; xp <= x1; xp++) {
      if (window.DEBUG) {
        window.debug.fbinIndex += 1;
      }

      const dx = xp - x;
      const dx2 = dx * dx;

      const r2 = dx2 + dy2;
      if(r2 > radius2) {
        const o = window.debugContent.orientationCompute[window.debug.keyframeIndex][window.debug.orientationComputeIndex];
        if (o.fbins[window.debug.fbinIndex] !== null) {
          console.log("INCORRECT fbin null");
        }
        continue; // only use the gradients within the circular window
      }


      const gradientValue = gradient.values[ yp * gradient.width + xp ];
      const angle = gradientValue.angle;
      const mag = gradientValue.mag;

      const w = _fastExp6({x: r2 * gwScale}); // Compute the gaussian weight based on distance from center of keypoint

      const fbin  = ORIENTATION_NUM_BINS * angle * ONE_OVER_2PI;

      const bin = Math.floor(fbin - 0.5);
      const w2 = fbin - bin - 0.5;
      const w1 = (1.0 - w2);
      const b1 = (bin + ORIENTATION_NUM_BINS) % ORIENTATION_NUM_BINS;
      const b2 = (bin + 1) % ORIENTATION_NUM_BINS;
      const magnitude = w * mag;

      if (window.DEBUG) {
        const o = window.debugContent.orientationCompute[window.debug.keyframeIndex][window.debug.orientationComputeIndex];
        if (Math.abs(fbin - o.fbins[window.debug.fbinIndex]) > 0.001) {
          console.log("INCORRECT fbin", r2, radius2, fbin, 'vs', o.fbins[window.debug.fbinIndex]);
        }
        const details = o.fbinDetails[window.debug.fbinIndex];
        if (b1 !== details.b1 || b2 !== details.b2) {
          console.log("INCORRECT b1b2", b1, b2, details.b1, details.b2);
        }
        if (Math.abs(w1 - details.w1) > 0.001 || Math.abs(w2 - details.w2) > 0.001) {
          console.log("INCORRECT w1w2", w1, w2, details.w1, details.w2);
        }
        if (Math.abs(details.magnitude - magnitude) > 0.001) {
          console.log("INCORRECT mag: ", magnitude, details.magnitude);
        }
      }

      histogram[b1] += w1 * magnitude;
      histogram[b2] += w2 * magnitude;
    }
  }

  if (window.DEBUG) {
    const o = window.debugContent.orientationCompute[window.debug.keyframeIndex][window.debug.orientationComputeIndex];
    for (let i = 0; i < histogram.length; i++) {
      if (Math.abs(o.histograms[i] - histogram[i]) > 0.001) {
        console.log("INCORRECT histogram", i, window.debug.orientationComputeIndex, JSON.stringify(o.histograms), JSON.stringify(histogram));
        console.log(o, 'vs', {x, y, sigma, octave });
        break;
      }
    }
  }

  //console.log("ori: ", x, y, octave, scale, gwSigma, gwScale, radius, radius2, JSON.stringify(histogram));

  // The orientation histogram is smoothed with a Gaussian
  // sigma=1
  const kernel = [0.274068619061197, 0.451862761877606, 0.274068619061197];
  for(let i = 0; i < ORIENTATION_SMOOTHING_ITERATIONS; i++) {
    const old = [];
    for (let j = 0; j < histogram.length; j++) {
      old[j] = histogram[j];
    }

    for (let j = 0; j < histogram.length; j++) {
      histogram[j] = kernel[0] * old[(j - 1 + histogram.length) % histogram.length]
                    + kernel[1] * old[j]
                    + kernel[2] * old[(j+1) % histogram.length];
    }
  }

  // Find the peak of the histogram.
  let maxHeight = 0;
  for(let i = 0; i < ORIENTATION_NUM_BINS; i++) {
    if(histogram[i] > maxHeight) {
      maxHeight = histogram[i];
    }
  }

  if (maxHeight === 0) {
    return [];
  }

  // Find all the peaks.
  const angles = [];
  for(let i = 0; i < ORIENTATION_NUM_BINS; i++) {
    const prev = (i - 1 + histogram.length) % histogram.length;
    const next = (i + 1) % histogram.length;

    if (histogram[i] > ORIENTATION_PEAK_THRESHOLD * maxHeight && histogram[i] > histogram[prev] && histogram[i] > histogram[next]) {
      // The default sub-pixel bin location is the discrete location if the quadratic fitting fails.
      let fbin = i;

      const ret = _quadratic3Points({
        p1: [i-1, histogram[prev]],
        p2: [i, histogram[i]],
        p3: [i+1, histogram[next]]
      });

      if (ret !== null) {
        const {A, B, C} = ret;

        // Find the critical point of a quadratic. y = A*x^2 + B*x + C
        if (A != 0) {
          fbin = -B / (2 * A);
        }
      }

      let an =  2.0 * Math.PI * ((fbin + 0.5 + ORIENTATION_NUM_BINS) / ORIENTATION_NUM_BINS);
      while (an > 2.0 * Math.PI) { // modula
        an -= 2.0 * Math.PI;
      }
      angles.push(an);
    }
  }
  return angles;
}



/**
 * Fit a quatratic to 3 points. The system of equations is:
 *
 * y0 = A*x0^2 + B*x0 + C
 * y1 = A*x1^2 + B*x1 + C
 * y2 = A*x2^2 + B*x2 + C
 *
 * This system of equations is solved for A,B,C.
 */
const _quadratic3Points = (options) => {
  const {p1, p2, p3} = options;
  const d1 = (p3[0]-p2[0])*(p3[0]-p1[0]);
  const d2 = (p1[0]-p2[0])*(p3[0]-p1[0]);
  const d3 = p1[0]-p2[0];

  // If any of the denominators are zero then return FALSE.
  if (d1 == 0 || d2 == 0 || d3 == 0) {
    return null;
  }

  const a = p1[0]*p1[0];
  const b = p2[0]*p2[0];

  // Solve for the coefficients A,B,C
  const A = ((p3[1]-p2[1])/d1)-((p1[1]-p2[1])/d2);
  const B = ((p1[1]-p2[1])+(A*(b-a)))/d3;
  const C = p1[1]-(A*a)-(B*p1[0]);

  return {A, B, C};
}

/**
 * 0.01% error at 1.030
 * 0.10% error at 1.520
 * 1.00% error at 2.330
 * 5.00% error at 3.285
 */
const _fastExp6 = (options) => {
  const {x} = options;
  return (720+x*(720+x*(360+x*(120+x*(30+x*(6+x))))))*0.0013888888;
}

const _computeGradients = (options) => {
  const {pyramid} = options;
  const gradients = [];

  for (let k = 0; k < pyramid.images.length; k++) {
    const values = [];
    const image = pyramid.images[k];

    for (let j = 0; j < image.height; j++) {
      const prevJ = j > 0? j - 1: j;
      const nextJ = j < image.height - 1? j + 1: j;

      for (let i = 0; i < image.width; i++) {
        const prevI = i > 0? i - 1: i;
        const nextI = i < image.width - 1? i + 1: i;
        const dx = image.data[j * image.width + nextI] - image.data[j * image.width + prevI];
        const dy = image.data[nextJ * image.width + i] - image.data[prevJ * image.width + i];

        values.push({
          angle: Math.atan2(dy, dx) + Math.PI,
          mag: Math.sqrt(dx * dx + dy * dy)
        });
      }
    }
    gradients.push({
      width: image.width,
      height: image.height,
      values: values
    });
  }
  return gradients;
}

// divide the image into PRUNE_FEATURES_NUM_BUCKETS * PRUNE_FEATURES_NUM_BUCKETS area
// in each area, sort feature points by score, and return the top N
const _pruneFeatures = (options) => {
  const {featurePoints, width, height} = options;

  // Note: seems not to be a consistent implementation. Might need to remove this line
  //   The feature points are prune per bucket, e.g. if 501 points in bucket 1, turns out only 5 valid
  //   Similarly, if 500 points all in bucket 1, they all passed because globally <= maxNumFeaturePoints
  if (featurePoints.length <= MAX_FEATURE_POINTS) return featurePoints;

  const resultFeaturePoints = [];

  const nBuckets = PRUNE_FEATURES_NUM_BUCKETS * PRUNE_FEATURES_NUM_BUCKETS;
  const nPointsPerBuckets = MAX_FEATURE_POINTS / nBuckets;

  const buckets = [];
  for (let i = 0; i < nBuckets; i++) {
    buckets.push([]);
  }

  const dx = Math.ceil(1.0 * width / PRUNE_FEATURES_NUM_BUCKETS);
  const dy = Math.ceil(1.0 * height / PRUNE_FEATURES_NUM_BUCKETS);

  for (let i = 0; i < featurePoints.length; i++) {
    const bucketX = Math.floor(featurePoints[i].x / dx);
    const bucketY = Math.floor(featurePoints[i].y / dy);

    const bucketIndex = bucketY * PRUNE_FEATURES_NUM_BUCKETS + bucketX;
    buckets[bucketIndex].push(featurePoints[i]);
  }

  for (let i = 0; i < PRUNE_FEATURES_NUM_BUCKETS; i++) {
    for (let j = 0; j < PRUNE_FEATURES_NUM_BUCKETS; j++) {
      const bucketIndex = j * PRUNE_FEATURES_NUM_BUCKETS + i;
      const bucket = buckets[bucketIndex];
      const nSelected = Math.min(bucket.length, nPointsPerBuckets);

      if (bucket.length > nSelected) {
        bucket.sort((f1, f2) => {
          return Math.abs(f1.score) > Math.abs(f2.score)? -1: 1;
        });
      }
      for (let k = 0; k < nSelected; k++) {
        resultFeaturePoints.push(bucket[k]);
      }
    }
  }
  return resultFeaturePoints;
}

// solve x = Ab, where A is symmetric
// [x0]   [A0 A1 A2] [b0]
// [x1] = [A3 A4 A5] [b1]
// [x2]   [A6 A7 A8] [b2]
const _solveSymmetric33 = (options) => {
  const {A, b} = options;

  const det = A[0] * A[4] * A[8]
            - A[0] * A[5] * A[5]
            - A[4] * A[2] * A[2]
            - A[8] * A[1] * A[1]
            + 2 * A[1] * A[2] * A[5];

  if ( Math.abs(det) < 0.0000001) return null; // determinant undefined. no solution

  const B = []; // inverse of A
  B[0] = A[4] * A[8] - A[5] * A[7];
  B[1] = A[2] * A[7] - A[1] * A[8];
  B[2] = A[1] * A[5] - A[2] * A[4];
  B[3] = A[5] * A[6] - A[3] * A[8];
  B[4] = A[0] * A[8] - A[2] * A[6];
  B[5] = A[2] * A[3] - A[0] * A[5];
  B[6] = A[3] * A[7] - A[4] * A[6];
  B[7] = A[1] * A[6] - A[0] * A[7];
  B[8] = A[0] * A[4] - A[1] * A[3];

  const x = [];
  x[0] = B[0] * b[0] + B[1] * b[1] + B[2] * b[2];
  x[1] = B[3] * b[0] + B[4] * b[1] + B[5] * b[2];
  x[2] = B[6] * b[0] + B[7] * b[1] + B[8] * b[2];

  x[0] = 1.0 * x[0] / det;
  x[1] = 1.0 * x[1] / det;
  x[2] = 1.0 * x[2] / det;

  return x;
}

module.exports = {
  detect
}

