#import <Cocoa/Cocoa.h>
#import <CoreServices/CoreServices.h>

static const unsigned long long MaxClipboardFileBytes = 50ULL * 1024ULL * 1024ULL;

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        if (argc < 2) {
            fprintf(stderr, "missing file path\n");
            return 64;
        }

        NSMutableArray<NSURL *> *urls = [NSMutableArray array];
        NSMutableArray<NSString *> *filePaths = [NSMutableArray array];
        NSFileManager *fileManager = [NSFileManager defaultManager];

        for (int index = 1; index < argc; index++) {
            NSString *path = [NSString stringWithUTF8String:argv[index]];
            if (path.length == 0) {
                continue;
            }

            path = [path stringByStandardizingPath];
            BOOL isDirectory = NO;
            if (![fileManager fileExistsAtPath:path isDirectory:&isDirectory]) {
                fprintf(stderr, "file does not exist: %s\n", path.UTF8String);
                return 66;
            }

            NSURL *fileURL = [NSURL fileURLWithPath:path isDirectory:isDirectory];
            [urls addObject:fileURL];
            [filePaths addObject:path];
        }

        if (urls.count == 0) {
            fprintf(stderr, "missing file path\n");
            return 64;
        }

        NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
        [pasteboard clearContents];

        if (![pasteboard writeObjects:urls]) {
            fprintf(stderr, "failed to write file urls to pasteboard\n");
            return 1;
        }

        NSMutableString *names = [NSMutableString string];
        for (NSURL *fileURL in urls) {
            NSString *name = nil;
            if (![fileURL getResourceValue:&name forKey:NSURLLocalizedNameKey error:NULL] || name.length == 0) {
                name = fileURL.lastPathComponent ?: @"";
            }

            if (name.length == 0) {
                continue;
            }
            if (names.length) {
                [names appendString:@"\r"];
            }
            [names appendString:name];
        }

        if (names.length > 0) {
            [pasteboard addTypes:@[(NSString *)kUTTypeUTF8PlainText] owner:nil];
            [pasteboard setString:names forType:(NSString *)kUTTypeUTF8PlainText];
        }

        return 0;
    }
}
