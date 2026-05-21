// Active Sportz — Splicer Obj-C++ bridge declarations for the RN module
// registry. The implementation is in Splicer.swift.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(Splicer, NSObject)

RCT_EXTERN_METHOD(splice:(NSString *)masterPath
                  segments:(NSArray *)segments
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
